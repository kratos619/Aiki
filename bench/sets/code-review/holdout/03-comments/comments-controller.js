const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');
const User = require('../models/User');

// GET /posts/:postId/comments?page=1 — comments with author names
router.get('/posts/:postId/comments', async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const perPage = 25;
  const comments = await Comment.find({ post: req.params.postId })
    .skip((page - 1) * perPage)
    .limit(perPage + 1);
  const out = [];
  for (const c of comments) {
    const author = await User.findById(c.authorId);
    out.push({ body: c.body, author: author.name });
  }
  res.json(out);
});

// DELETE /comments/:id — delete a comment
router.delete('/comments/:id', authenticate, async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  await comment.deleteOne();
  res.status(204).end();
});

module.exports = router;
