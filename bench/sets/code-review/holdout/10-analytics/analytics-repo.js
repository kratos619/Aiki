const Order = require('../models/Order');
const Event = require('../models/Event');
const Widget = require('../models/Widget');

// Daily revenue for the last `days` days
async function dailyRevenue(days) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const out = [];
  for (let d = 0; d <= days; d++) {
    const from = new Date(start.getTime() + d * 86400000);
    const to = new Date(from.getTime() + 86400000);
    const orders = await Order.find({ createdAt: { $gte: from, $lt: to } });
    out.push({ day: from, revenue: orders.reduce((s, o) => s + o.total, 0) });
  }
  return out;
}

// Count events matching a caller-provided filter expression
async function countWhere(expr) {
  return Event.countDocuments({ $where: expr });
}

// Increment the view counter for a dashboard widget
async function bumpViews(widgetId) {
  const w = await Widget.findById(widgetId);
  w.views = w.views + 1;
  await w.save();
}

module.exports = { dailyRevenue, countWhere, bumpViews };
