const DonationType = require('../models/donationtypes');

// Create a new donation type
const createDonationType = async (req, res) => {
  try {
    const { donationType } = req.body;
    
    // Get the highest sortOrder value and add 1
    const maxOrder = await DonationType.findOne().sort({ sortOrder: -1 });
    const sortOrder = maxOrder ? maxOrder.sortOrder + 1 : 0;
    
    const newDonationType = new DonationType({
      donationType,
      sortOrder
    });
    
    const savedDonationType = await newDonationType.save();
    
    res.status(201).json({
      success: true,
      message: 'Donation type created successfully',
      data: savedDonationType
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Donation type already exists'
      });
    }
    
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Get all donation types
const getDonationTypes = async (req, res) => {
  try {
    const donationTypes = await DonationType.find().sort({ sortOrder: 1 });
    
    res.status(200).json({
      success: true,
      count: donationTypes.length,
      data: donationTypes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Get single donation type by ID
const getDonationTypeById = async (req, res) => {
  try {
    const donationType = await DonationType.findById(req.params.id);
    
    if (!donationType) {
      return res.status(404).json({
        success: false,
        message: 'Donation type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: donationType
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Update donation type
const updateDonationType = async (req, res) => {
  try {
    const { donationType } = req.body;
    
    const updatedDonationType = await DonationType.findByIdAndUpdate(
      req.params.id,
      { donationType },
      { new: true, runValidators: true }
    );
    
    if (!updatedDonationType) {
      return res.status(404).json({
        success: false,
        message: 'Donation type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Donation type updated successfully',
      data: updatedDonationType
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Donation type already exists'
      });
    }
    
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Delete donation type
const deleteDonationType = async (req, res) => {
  try {
    const donationType = await DonationType.findByIdAndDelete(req.params.id);
    
    if (!donationType) {
      return res.status(404).json({
        success: false,
        message: 'Donation type not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Donation type deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Reorder donation types
const reorderDonationTypes = async (req, res) => {
  try {
    const { orderedIds } = req.body; // Array of IDs in new order
    
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({
        success: false,
        message: 'orderedIds must be an array'
      });
    }
    
    // Update sortOrder for each donation type
    const updatePromises = orderedIds.map((id, index) => 
      DonationType.findByIdAndUpdate(id, { sortOrder: index })
    );
    
    await Promise.all(updatePromises);
    
    // Get updated list
    const donationTypes = await DonationType.find().sort({ sortOrder: 1 });
    
    res.status(200).json({
      success: true,
      message: 'Donation types reordered successfully',
      data: donationTypes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  createDonationType,
  getDonationTypes,
  getDonationTypeById,
  updateDonationType,
  deleteDonationType,
  reorderDonationTypes
};