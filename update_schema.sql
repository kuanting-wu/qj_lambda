-- This SQL will update the database schema to fix any compatibility issues

-- 1. Update the profiles table user_id to match the users table id (BIGINT)
ALTER TABLE profiles
ALTER COLUMN user_id TYPE BIGINT;

-- 2. Update the hashed_password column to be long enough for bcrypt hashes
ALTER TABLE users 
ALTER COLUMN hashed_password TYPE VARCHAR(255);

-- 3. Update verification_token and reset_token to be long enough for UUID values
ALTER TABLE users
ALTER COLUMN verification_token TYPE VARCHAR(255),
ALTER COLUMN reset_token TYPE VARCHAR(255);

-- 4. Add indexes to improve performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_users_verification_token ON users(verification_token) WHERE verification_token IS NOT NULL;

