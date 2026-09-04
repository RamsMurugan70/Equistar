const dashboardRepository = require('../../repositories/dashboardRepository');

async function getDashboard() {
  return dashboardRepository.getDashboardSummary();
}

async function getDashboardInsights() {
  return dashboardRepository.getDashboardInsights();
}

module.exports = {
  getDashboard,
  getDashboardInsights,
};
