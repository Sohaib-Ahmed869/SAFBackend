// One-off diagnostic: list admin-created / "manual" test donor records and
// whether they carry the createdByAdmin flag the donors list filters on.
// Read-only. Usage: node scripts/checkManualDonors.js
require("dotenv").config();
// Same workaround as server.js: the default resolver can't do SRV lookups here.
require("dns").setServers(["1.1.1.1", "8.8.8.8"]);
const mongoose = require("mongoose");
const User = require("../models/user");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await User.find({
    $or: [
      { createdByAdmin: true },
      { email: /manual/i },
      { name: /manual/i },
    ],
  })
    .select("name email createdByAdmin isPlaceholderEmail isTemporaryPassword createdAt")
    .lean();

  console.log(`${users.length} matching user(s):`);
  users.forEach((u) => {
    console.log(
      JSON.stringify({
        _id: String(u._id),
        name: u.name,
        email: u.email,
        createdByAdmin: u.createdByAdmin ?? "(missing)",
        isPlaceholderEmail: u.isPlaceholderEmail ?? "(missing)",
        createdAt: u.createdAt,
      })
    );
  });
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
