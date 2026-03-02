const Join = require("../models/join");

exports.createJoin = async (req, res) => {
  try {
    console.log(req.body);
    const join = await Join.create(req.body);
    res.status(201).json(join);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.getAllJoin = async (req, res) => {
  try {
    const joins = await Join.find().sort({ createdAt: -1 });
    res.status(200).json(joins);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

exports.deleteJoin = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Join.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ error: "Application not found" });
    }
    res.status(200).json({ message: "Application deleted successfully", id });
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};
