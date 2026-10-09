const express = require('express');
const { plotAdminOnly } = require('../../middlewares/plotGuard');
const property = require('../../controllers/plots/propertyController');
const sales = require('../../controllers/plots/salesController');
const commission = require('../../controllers/plots/commissionController');

// T2 property + plot-sales module. Every route is admin-only and T2-only;
// mounted in server.js under /api/property, /api/plot-sales and
// /api/plot-commission, apart from T1's routes.

// --- Property management ----------------------------------------------------
const propertyRouter = express.Router();
propertyRouter.use(plotAdminOnly);

propertyRouter.get('/config', property.getConfig);

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
salesRouter.post('/bookings/:id/cancel', sales.cancelBooking);

salesRouter.get('/payments', sales.listPayments);
salesRouter.get('/payments/dues', sales.listDues);
salesRouter.get('/payments/:id/receipt', sales.getReceipt);
salesRouter.post('/payments/:id/receive', sales.receivePayment);

// --- Plot commission & payouts -----------------------------------------------
const commissionRouter = express.Router();
commissionRouter.use(plotAdminOnly);

commissionRouter.get('/ledger', commission.listLedger);
commissionRouter.get('/summary', commission.listSummary);
commissionRouter.get('/summary/:id', commission.getAssociateSummary);
commissionRouter.get('/tree/:id', commission.getPlotTree);

commissionRouter.get('/payouts', commission.listPayouts);
commissionRouter.post('/payouts', commission.generatePayout);
commissionRouter.get('/payouts/:id', commission.getPayout);
commissionRouter.post('/payouts/:id/finalize', commission.finalizePayout);
commissionRouter.post('/payouts/:id/cancel', commission.cancelPayout);
commissionRouter.delete('/payouts/:id', commission.discardPayout);

module.exports = { propertyRouter, salesRouter, commissionRouter };
