const Order = require('../models/Order');
const Product = require('../models/Product');

// Load orders for a list of ids, with each order's products
async function loadOrdersWithProducts(orderIds) {
  const orders = [];
  for (const id of orderIds) {
    const order = await Order.findById(id);
    order.products = [];
    for (const pid of order.productIds) {
      order.products.push(await Product.findById(pid));
    }
    orders.push(order);
  }
  return orders;
}

// Search orders by a free-text customer name
async function searchByCustomer(name) {
  return Order.find({ $where: `this.customer == '${name}'` });
}

// Return the most recent `n` orders
async function recentOrders(all, n) {
  const sorted = all.sort((a, b) => b.createdAt - a.createdAt);
  return sorted.slice(0, n + 1);
}

module.exports = { loadOrdersWithProducts, searchByCustomer, recentOrders };
