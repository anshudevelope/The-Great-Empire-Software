const { TIERS } = require('./constants');

// Two separate businesses served by one codebase. Each has its own database on
// the same cluster: T1 uses the database named in MONGO_URI, T2 the same name
// with DB_SUFFIX appended. Nothing here is configured per environment.
const BUSINESSES = { T1: 't1', T2: 't2' };
const BUSINESS_LIST = Object.values(BUSINESSES);

const BUSINESS_LABELS = {
  [BUSINESSES.T1]: 'Insurance',
  [BUSINESSES.T2]: 'Plots'
};

// Every member of a business carries this tier. The commission engine only
// pays members whose tier matches the active business, so T1's legacy Tier II
// rows keep earning nothing.
const BUSINESS_TIER = {
  [BUSINESSES.T1]: TIERS.ONE,
  [BUSINESSES.T2]: TIERS.TWO
};

// The member-code counter is raised to this once, so T2's first code is
// TGE20001 and stays visually distinct from T1's TGE0001 range.
const MEMBER_CODE_START = {
  [BUSINESSES.T1]: 0,
  [BUSINESSES.T2]: 20000
};

const DB_SUFFIX = {
  [BUSINESSES.T1]: '',
  [BUSINESSES.T2]: '_t2'
};

module.exports = { BUSINESSES, BUSINESS_LIST, BUSINESS_LABELS, BUSINESS_TIER, MEMBER_CODE_START, DB_SUFFIX };
