const { AsyncLocalStorage } = require('node:async_hooks');
const mongoose = require('mongoose');
const { BUSINESSES, DB_SUFFIX } = require('../config/business');

/**
 * Which business the current request works in.
 *
 * Set once per request by businessMiddleware and carried through every await,
 * including the commission run that starts after a placement commits. Code
 * running outside a request (scripts, tests) sees T1, which is exactly how it
 * behaved before T2 existed.
 */
const storage = new AsyncLocalStorage();

const currentBusiness = () => storage.getStore()?.business ?? BUSINESSES.T1;

const runInBusiness = (business, fn) => storage.run({ business }, fn);

// Every schema bound through bindModel, so a new business connection can
// compile all of them up front. populate() resolves refs by name on the
// document's own connection — a model missing there is a MissingSchemaError.
const registry = new Map();

const registeredModelNames = () => [...registry.keys()];

/**
 * T1 is the default connection itself. Other businesses are sibling databases
 * on the same MongoClient (useDb), so they share the pool and the credentials
 * and a session started on one works on the other.
 */
const connectionFor = (business) => {
  if (business === BUSINESSES.T1) return mongoose.connection;

  const base = mongoose.connection.name;
  if (!base) throw new Error('MongoDB is not connected yet.');

  const conn = mongoose.connection.useDb(`${base}${DB_SUFFIX[business]}`, { useCache: true });
  for (const [name, schema] of registry) {
    if (!conn.models[name]) conn.model(name, schema);
  }
  return conn;
};

/**
 * Replaces `mongoose.model(name, schema)` in every model file.
 *
 * Returns a Proxy that resolves to the active business's model on every
 * access, so the existing `require('../models/Associate')` call sites keep
 * working unchanged and simply read whichever database the request is in.
 * Functions are bound to the real model so Mongoose's internals never see the
 * Proxy as `this`.
 */
const bindModel = (name, schema) => {
  registry.set(name, schema);
  const t1Model = mongoose.model(name, schema);

  const resolve = () => {
    const business = currentBusiness();
    return business === BUSINESSES.T1 ? t1Model : connectionFor(business).models[name];
  };

  return new Proxy(function BoundModel() {}, {
    get(_target, prop) {
      const model = resolve();
      const value = Reflect.get(model, prop, model);
      return typeof value === 'function' && prop !== 'prototype' ? value.bind(model) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolve(), prop, value);
    },
    has(_target, prop) {
      return prop in resolve();
    },
    construct(_target, args) {
      return Reflect.construct(resolve(), args);
    },
    apply(_target, thisArg, args) {
      return Reflect.apply(resolve(), thisArg, args);
    }
  });
};

module.exports = { currentBusiness, runInBusiness, connectionFor, bindModel, registeredModelNames };
