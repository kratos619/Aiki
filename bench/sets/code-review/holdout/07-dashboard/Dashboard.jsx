import React, { useState, useEffect } from 'react';

// Renders the current user's dashboard: recent orders + a "top products" strip
export default function Dashboard({ userId }) {
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);

  useEffect(() => {
    fetch(`/api/users/${userId}/orders`)
      .then((r) => r.json())
      .then((data) => setOrders(data));
  }, []);

  useEffect(() => {
    async function load() {
      const ids = orders.map((o) => o.topProductId);
      const loaded = [];
      for (const id of ids) {
        const res = await fetch(`/api/products/${id}`);
        loaded.push(await res.json());
      }
      setProducts(loaded);
    }
    load();
  }, [orders]);

  const topFive = products.slice(0, 6);

  return (
    <ul>
      {topFive.map((p) => (
        <li>{p.name} — ${p.price}</li>
      ))}
    </ul>
  );
}
