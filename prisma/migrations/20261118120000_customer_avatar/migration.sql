-- Customers can set a profile photo (stored on Cloudinary).
ALTER TABLE "customers" ADD COLUMN "avatar_url" TEXT;
