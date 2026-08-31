const Associate = require('../models/Associate');
const bcrypt = require('bcryptjs');
const { cloudinary } = require('../config/cloudinary');

// 1. REGISTER ASSOCIATE
exports.registerAssociate = async (req, res) => {
  try {
    const {
      title, fullName, fatherOrHusbandName, maritalStatus, gender, phone, email,
      password, dob, age, address, city, country, state, pinCode,
      nomineeName, nomineeRelation, nomineeAge, sponsorId, tier
    } = req.body;

    const existingUser = await Associate.findOne({ $or: [{ email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email or Phone already registered.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let profileImageData = {};
    if (req.files && req.files['profileImage'] && req.files['profileImage'][0]) {
      const file = req.files['profileImage'][0];
      profileImageData = { url: file.path, public_id: file.filename };
    }

    let documentList = [];
    if (req.files && req.files['documents']) {
      documentList = req.files['documents'].map((file, index) => ({
        docType: req.body[`docType_${index}`] || 'KYC Document',
        url: file.path,
        public_id: file.filename
      }));
    }

    const newAssociate = new Associate({
      title, fullName, fatherOrHusbandName, maritalStatus, gender, phone, email,
      password: hashedPassword, dob, age, address, city, country, state, pinCode,
      nomineeName, nomineeRelation, nomineeAge, sponsorId: sponsorId || null,
      tier: tier || 'Tier I', status: 'pending',
      profileImage: profileImageData, documents: documentList
    });

    await newAssociate.save();
    res.status(201).json({
      success: true,
      message: 'Registration successful! Account pending admin approval.',
      data: newAssociate
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. VIEW ALL ASSOCIATES (Admin)
exports.getAllAssociates = async (req, res) => {
  try {
    const { status, tier, search } = req.query;
    let filter = {};

    if (status) filter.status = status;
    if (tier) filter.tier = tier;
    if (search) {
      filter.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    const associates = await Associate.find(filter)
      .select('-password')
      .populate('sponsorId', 'fullName email phone');

    res.status(200).json({ success: true, count: associates.length, data: associates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. VIEW ASSOCIATE BY ID
exports.getAssociateById = async (req, res) => {
  try {
    const associate = await Associate.findById(req.params.id)
      .select('-password')
      .populate('sponsorId', 'fullName email phone');

    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    res.status(200).json({ success: true, data: associate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 4. EDIT ASSOCIATE
exports.updateAssociate = async (req, res) => {
  try {
    let updateFields = { ...req.body };

    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    // Handle password update if provided, otherwise exclude from update object
    if (updateFields.password && updateFields.password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      updateFields.password = await bcrypt.hash(updateFields.password, salt);
    } else {
      delete updateFields.password;
    }

    // Handle profile image update
    if (req.files && req.files['profileImage'] && req.files['profileImage'][0]) {
      if (associate.profileImage && associate.profileImage.public_id) {
        await cloudinary.uploader.destroy(associate.profileImage.public_id);
      }
      const file = req.files['profileImage'][0];
      updateFields.profileImage = { url: file.path, public_id: file.filename };
    }

    // Handle new documents upload
    if (req.files && req.files['documents']) {
      const newDocs = req.files['documents'].map((file, index) => ({
        docType: req.body[`docType_${index}`] || 'KYC Document',
        url: file.path,
        public_id: file.filename
      }));

      // Append new documents to existing list
      updateFields.documents = [...(associate.documents || []), ...newDocs];
    }

    const updatedAssociate = await Associate.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true, runValidators: true }
    ).select('-password');

    res.status(200).json({ success: true, message: 'Associate updated successfully', data: updatedAssociate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 5. APPROVE / REJECT REGISTRATION (ADMIN ONLY)
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    const associate = await Associate.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).select('-password');

    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    res.status(200).json({
      success: true,
      message: `Associate registration status updated to ${status}`,
      data: associate
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 6. DELETE ASSOCIATE
exports.deleteAssociate = async (req, res) => {
  try {
    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    // Cleanup profile image from Cloudinary
    if (associate.profileImage && associate.profileImage.public_id) {
      await cloudinary.uploader.destroy(associate.profileImage.public_id);
    }

    // Cleanup all documents from Cloudinary
    if (associate.documents && associate.documents.length > 0) {
      for (const doc of associate.documents) {
        if (doc.public_id) {
          await cloudinary.uploader.destroy(doc.public_id);
        }
      }
    }

    await Associate.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Associate deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};