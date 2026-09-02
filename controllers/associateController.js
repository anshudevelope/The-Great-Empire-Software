const Associate = require('../models/Associate');
const bcrypt = require('bcryptjs');
const { cloudinary } = require('../config/cloudinary');

// Helper function to dynamically search and find the next available extreme position (Spillover)
const findExtremeNode = async (startParentId, position) => {
  let currentParent = await Associate.findById(startParentId);
  while (currentParent) {
    const nextChildId = position === 'Left' ? currentParent.leftChild : currentParent.rightChild;
    if (!nextChildId) return currentParent._id;
    currentParent = await Associate.findById(nextChildId);
  }
  return startParentId;
};

// 1. REGISTER ASSOCIATE WITH BINARY PLACEMENT
exports.registerAssociate = async (req, res) => {
  try {
    const {
      title, fullName, fatherOrHusbandName, maritalStatus, gender, phone, email,
      password, dob, age, address, city, country, state, pinCode,
      nomineeName, nomineeRelation, nomineeAge, sponsorId, parentId, position, tier
    } = req.body;

    const existingUser = await Associate.findOne({ $or: [{ email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email or Phone already registered.' });
    }

    let targetParentId = parentId || sponsorId || null;
    let targetPosition = position || null;

    // Validate Placement Logic
    if (targetParentId && targetPosition) {
      if (!['Left', 'Right'].includes(targetPosition)) {
        return res.status(400).json({ success: false, message: 'Position must be either "Left" or "Right".' });
      }

      let parentNode = await Associate.findById(targetParentId);
      if (!parentNode) {
        return res.status(404).json({ success: false, message: 'Specified Parent node not found.' });
      }

      const existingChild = targetPosition === 'Left' ? parentNode.leftChild : parentNode.rightChild;

      // Automatic Spillover: If chosen spot is occupied, automatically route down that leg to the extreme bottom
      if (existingChild) {
        targetParentId = await findExtremeNode(targetParentId, targetPosition);
      }
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
      nomineeName, nomineeRelation, nomineeAge,
      sponsorId: sponsorId || null,
      parentId: targetParentId,
      position: targetPosition,
      tier: tier || 'Tier I',
      status: 'pending',
      profileImage: profileImageData,
      documents: documentList
    });

    await newAssociate.save();

    // Attach child reference to parent node
    if (targetParentId && targetPosition) {
      const updateField = targetPosition === 'Left' ? { leftChild: newAssociate._id } : { rightChild: newAssociate._id };
      await Associate.findByIdAndUpdate(targetParentId, updateField);
    }

    res.status(201).json({
      success: true,
      message: 'Registration successful! Account pending admin approval.',
      data: newAssociate
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. VIEW BINARY TREE STRUCTURE (Recursive Tree Fetching)
exports.getBinaryTree = async (req, res) => {
  try {
    const { id } = req.params;
    const depth = parseInt(req.query.depth) || 3; // Default 3 levels deep for UI rendering

    const fetchTree = async (associateId, currentDepth) => {
      if (!associateId || currentDepth > depth) return null;

      const associate = await Associate.findById(associateId)
        .select('fullName email phone role status position profileImage leftChild rightChild sponsorId')
        .lean();

      if (!associate) return null;

      associate.left = await fetchTree(associate.leftChild, currentDepth + 1);
      associate.right = await fetchTree(associate.rightChild, currentDepth + 1);

      return associate;
    };

    const treeData = await fetchTree(id, 1);
    if (!treeData) return res.status(404).json({ success: false, message: 'Associate not found' });

    res.status(200).json({ success: true, data: treeData });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 3. VIEW ALL ASSOCIATES
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
      .populate('sponsorId', 'fullName email phone')
      .populate('parentId', 'fullName email phone')
      .populate('leftChild', 'fullName email phone')
      .populate('rightChild', 'fullName email phone');

    res.status(200).json({ success: true, count: associates.length, data: associates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 4. VIEW ASSOCIATE BY ID
exports.getAssociateById = async (req, res) => {
  try {
    const associate = await Associate.findById(req.params.id)
      .select('-password')
      .populate('sponsorId', 'fullName email phone')
      .populate('parentId', 'fullName email phone')
      .populate('leftChild', 'fullName email phone')
      .populate('rightChild', 'fullName email phone');

    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    res.status(200).json({ success: true, data: associate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 5. EDIT ASSOCIATE
exports.updateAssociate = async (req, res) => {
  try {
    let updateFields = { ...req.body };

    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    if (updateFields.password && updateFields.password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      updateFields.password = await bcrypt.hash(updateFields.password, salt);
    } else {
      delete updateFields.password;
    }

    if (req.files && req.files['profileImage'] && req.files['profileImage'][0]) {
      if (associate.profileImage && associate.profileImage.public_id) {
        await cloudinary.uploader.destroy(associate.profileImage.public_id);
      }
      const file = req.files['profileImage'][0];
      updateFields.profileImage = { url: file.path, public_id: file.filename };
    }

    if (req.files && req.files['documents']) {
      const newDocs = req.files['documents'].map((file, index) => ({
        docType: req.body[`docType_${index}`] || 'KYC Document',
        url: file.path,
        public_id: file.filename
      }));
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

// 6. APPROVE / REJECT REGISTRATION
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

    res.status(200).json({ success: true, message: `Associate registration status updated to ${status}`, data: associate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 7. DELETE ASSOCIATE
exports.deleteAssociate = async (req, res) => {
  try {
    const associate = await Associate.findById(req.params.id);
    if (!associate) return res.status(404).json({ success: false, message: 'Associate not found' });

    if (associate.profileImage && associate.profileImage.public_id) {
      await cloudinary.uploader.destroy(associate.profileImage.public_id);
    }

    if (associate.documents && associate.documents.length > 0) {
      for (const doc of associate.documents) {
        if (doc.public_id) await cloudinary.uploader.destroy(doc.public_id);
      }
    }

    // Clean up tree parent references
    if (associate.parentId && associate.position) {
      const clearField = associate.position === 'Left' ? { leftChild: null } : { rightChild: null };
      await Associate.findByIdAndUpdate(associate.parentId, clearField);
    }

    await Associate.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Associate deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};