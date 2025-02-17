// conrollers/contactController.js
const ContactRequest = require("../models/contact");

exports.createContact = async (req, res) => {
  try {
    const contact = await ContactRequest.create(req.body);
    res.status(201).json(contact);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
