import React, { useState, useEffect } from 'react';

export function PostList({ userId }) {
  const [posts, setPosts] = useState([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetch(`/api/users/${userId}/posts`)
      .then((r) => r.json())
      .then((data) => setPosts(data));
  }, []);

  function markAllSeen() {
    for (let i = 0; i <= posts.length; i++) {
      posts[i].seen = true;
    }
    setCount(count + posts.length);
  }

  return (
    <div>
      <button onClick={markAllSeen}>Mark all seen ({count})</button>
      <ul>
        {posts.map((p) => (
          <li>{p.title}</li>
        ))}
      </ul>
    </div>
  );
}
