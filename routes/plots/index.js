const express = require('express');
const { plotAdminOnly, requireT2 } = require('../../middlewares/plotGuard');
const { requireAuth, scopeToDownline } = require('../../middlewares/authMiddleware');

// Member-readable routes: any logged-in T2 user, declared before each router's
// admin guard. scopeToDownline lets the admin through and an associate only
// into their own subtree, exactly as the T1 tree.
const t2Member = [requireAuth, requireT2];
const property = require('../../controllers/plots/propertyController');
const sales = require('../../controllers/plots/salesController');
const commission = require('../../controllers/plots/commissionController');

// T2 property + plot-sales module. Every route is T2-only and, bar the few
// member-readable ones marked below, admin-only;
// mounted in server.js under /api/property, /api/plot-sales and
// /api/plot-commission, apart from T1's routes.

// --- Property management ----------------------------------------------------
const propertyRouter = express.Router();
// The public plan settings (commission %s) — the member tree labels its plot rows with them.
propertyRouter.get('/config', t2Member, property.getConfig);
propertyRouter.use(plotAdminOnly);

propertyRouter.get('/companies', property.listCompanies);
propertyRouter.post('/companies', property.createCompany);
propertyRouter.get('/companies/:id', property.getCompany);
propertyRouter.put('/companies/:id', property.updateCompany);
propertyRouter.delete('/companies/:id', property.deleteCompany);

propertyRouter.get('/projects', property.listProjects);
propertyRouter.post('/projects', property.createProject);
propertyRouter.get('/projects/:id', property.getProject);
propertyRouter.put('/projects/:id', property.updateProject);
propertyRouter.delete('/projects/:id', property.deleteProject);

propertyRouter.get('/blocks', property.listBlocks);
propertyRouter.post('/blocks', property.createBlock);
propertyRouter.get('/blocks/:id', property.getBlock);
propertyRouter.put('/blocks/:id', property.updateBlock);
propertyRouter.delete('/blocks/:id', property.deleteBlock);
propertyRouter.post('/blocks/:id/plots', property.addPlots);

propertyRouter.get('/plots', property.listPlots);
propertyRouter.get('/plots/:id', property.getPlot);
propertyRouter.put('/plots/:id', property.updatePlot);
propertyRouter.post('/plots/:id/hold', property.holdPlot);
propertyRouter.post('/plots/:id/unhold', property.unholdPlot);

// --- Plot sales -------------------------------------------------------------
const salesRouter = express.Router();
salesRouter.use(plotAdminOnly);

salesRouter.get('/clients', sales.listClients);
salesRouter.post('/clients', sales.createClient);
salesRouter.get('/clients/by-mobile/:mobile', sales.findClientByMobile);
salesRouter.get('/clients/:id', sales.getClient);
salesRouter.put('/clients/:id', sales.updateClient);

salesRouter.get('/bookings/schedule-preview', sales.previewSchedule);
salesRouter.get('/bookings', sales.listBookings);
salesRouter.post('/bookings', sales.createBooking);
salesRouter.get('/bookings/:id', sales.getBooking);
salesRouter.get('/bookings/:id/payment-preview', sales.previewPayment);
salesRouter.post('/bookings/:id/payments', sales.recordPayment);
salesRouter.get('/bookings/:id/statement', sales.getStatement);
salesRouter.post('/bookings/:id/cancel', sales.cancelBooking);

salesRouter.get('/payments', sales.listPayments);
salesRouter.get('/payments/dues', sales.listDues);
salesRouter.get('/payments/emis', sales.listEmis);
salesRouter.get('/payments/:id/receipt', sales.getReceipt);

// --- Plot commission & payouts -----------------------------------------------
const commissionRouter = express.Router();
// The caller's own figures (Tier II rewards), and one downline member's plot
// position and plot tree (the member tree's hover card and plot tree view).
commissionRouter.get('/me', t2Member, commission.getMyLedger);
commissionRouter.get('/me/summary', t2Member, commission.getMySummary);
commissionRouter.get('/me/payouts', t2Member, commission.getMyPayouts);
commissionRouter.get('/summary/:id', t2Member, scopeToDownline('id'), commission.getAssociateSummary);
commissionRouter.get('/tree/:id', t2Member, scopeToDownline('id'), commission.getPlotTree);
commissionRouter.use(plotAdminOnly);

commissionRouter.get('/ledger', commission.listLedger);
commissionRouter.get('/summary', commission.listSummary);

commissionRouter.get('/payouts', commission.listPayouts);
commissionRouter.post('/payouts', commission.generatePayout);
commissionRouter.get('/payouts/next', commission.getNextPayoutPeriod);
commissionRouter.get('/payouts/:id', commission.getPayout);
commissionRouter.get('/payouts/:id/export', commission.exportPayout);
commissionRouter.post('/payouts/:id/finalize', commission.finalizePayout);
commissionRouter.post('/payouts/:id/cancel', commission.cancelPayout);
commissionRouter.delete('/payouts/:id', commission.discardPayout);

module.exports = { propertyRouter, salesRouter, commissionRouter };
