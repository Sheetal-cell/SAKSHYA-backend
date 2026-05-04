const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post("/google", async (req, res) => {
  try {
    const { token } = req.body;

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const user = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      googleId: payload.sub,
    };

    const appToken = jwt.sign(
      { email: user.email, googleId: user.googleId },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ user, token: appToken });

  } catch (err) {
    res.status(401).json({ error: "Invalid Google token" });
  }
});

module.exports = router;