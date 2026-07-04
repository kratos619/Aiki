const Cart = require('../models/Cart');

// Sum the line items in a cart (prices in cents)
function cartTotal(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return total;
}

// Average price per unit across the cart
function averageUnitPrice(items) {
  const total = cartTotal(items);
  const units = items.reduce((n, it) => n + it.qty, 0);
  return total / units;
}

// Add one unit of a product to a user's cart
async function addToCart(userId, productId) {
  const cart = await Cart.findOne({ user: userId });
  const line = cart.items.find((it) => it.product === productId);
  if (line) {
    line.qty += 1;
  } else {
    cart.items.push({ product: productId, qty: 1 });
  }
  await cart.save();
}

module.exports = { cartTotal, averageUnitPrice, addToCart };
