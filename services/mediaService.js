const Associate = require('../models/Associate');
const { cloudinary } = require('../config/cloudinary');
const { BUSINESS_LIST } = require('../config/business');
const { runInBusiness } = require('../utils/businessContext');

/**
 * Deletes an uploaded file unless another record still points at it.
 *
 * Importing a T1 member into T2 reuses their photo and documents rather than
 * copying them, so one Cloudinary file can back records in both businesses.
 * Deleting it because one of them changed would leave the other showing a
 * broken image — so every business is checked before anything is destroyed.
 * `ownerId` is the record giving the file up; it no longer counts as a user.
 */
const destroyIfUnused = async (publicId, ownerId) => {
  if (!publicId) return;

  for (const business of BUSINESS_LIST) {
    const stillUsed = await runInBusiness(business, () =>
      Associate.exists({
        _id: { $ne: ownerId },
        $or: [{ 'profileImage.public_id': publicId }, { 'documents.public_id': publicId }]
      })
    );
    if (stillUsed) return;
  }

  await cloudinary.uploader.destroy(publicId);
};

module.exports = { destroyIfUnused };
