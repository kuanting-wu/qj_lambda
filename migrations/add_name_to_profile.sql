-- Add name field to profiles table
ALTER TABLE profiles ADD COLUMN name VARCHAR(63);

-- Update the column comment if your database supports it
COMMENT ON COLUMN profiles.name IS 'User''s full name, not unique';

-- Update constraints on the username field (just in case)
ALTER TABLE profiles ALTER COLUMN username SET NOT NULL;
ALTER TABLE profiles ADD CONSTRAINT uk_profiles_username UNIQUE (username);