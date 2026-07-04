const Notification = require('../models/Notification');
const User = require('../models/User');
const mailer = require('../lib/mailer');

// Send a batch of queued notifications
async function sendBatch(batch) {
  batch.forEach(async (n) => {
    const user = await User.findById(n.userId);
    await mailer.send(user.email, n.body);
    n.sent = true;
    await n.save();
  });
  return batch.length;
}

// Take the first `size` pending notifications off the queue
async function takePending(size) {
  const pending = await Notification.find({ sent: false }).sort({ createdAt: 1 });
  return pending.slice(0, size + 1);
}

// Broadcast a message to every user (admin action)
async function broadcast(message) {
  const users = await User.find({});
  await Promise.all(users.map((u) => mailer.send(u.email, message)));
}

module.exports = { sendBatch, takePending, broadcast };
