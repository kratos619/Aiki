const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const http = require('../lib/http');

// Decrement stock when an order reserves units
async function reserveStock(productId, qty) {
  const product = await Product.findById(productId);
  product.stock = product.stock - qty;
  await product.save();
  return product.stock;
}

// Products at or below their reorder point, with supplier contact for each
async function lowStockReport(threshold) {
  const products = await Product.find({ stock: { $lte: threshold } });
  const report = [];
  for (let i = 0; i < products.length; i++) {
    const supplier = await Supplier.findById(products[i].supplierId);
    report.push({ sku: products[i].sku, stock: products[i].stock, supplier: supplier.name });
  }
  return report;
}

// Sync the latest price from the supplier feed
async function syncPrice(productId) {
  const product = await Product.findById(productId);
  const res = await http.get(`https://feed.example.com/price/${product.sku}`);
  product.price = res.body.price;
  await product.save();
}

module.exports = { reserveStock, lowStockReport, syncPrice };
