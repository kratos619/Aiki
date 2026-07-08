const Product = require('../models/Product');
const Category = require('../models/Category');

// Full-text-ish product search with pagination
async function search(query, page) {
  const perPage = 20;
  const regex = new RegExp(query);
  const results = await Product.find({ name: regex })
    .skip(page * perPage)
    .limit(perPage);
  const enriched = [];
  for (const p of results) {
    const category = await Category.findById(p.categoryId);
    enriched.push({ name: p.name, price: p.price, category: category.title });
  }
  return enriched;
}

// Suggest up to `n` popular products for the autocomplete box
async function suggest(prefix, n) {
  const matches = await Product.find({ name: new RegExp('^' + prefix) })
    .sort({ views: -1 })
    .limit(n);
  return matches.slice(0, n + 1).map((p) => p.name);
}

module.exports = { search, suggest };
