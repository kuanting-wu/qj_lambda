-- Create position_type enum if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'position_type') THEN
        CREATE TYPE position_type AS ENUM ('TOP', 'BOTTOM', 'NEUTRAL');
    END IF;
END$$;

-- Create game_plans table
CREATE TABLE IF NOT EXISTS game_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name VARCHAR(63) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create nodes table (positions)
CREATE TABLE IF NOT EXISTS nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position VARCHAR(63) UNIQUE NOT NULL,
    top_bottom position_type DEFAULT 'NEUTRAL',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create edges table (transitions)
CREATE TABLE IF NOT EXISTS edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_position VARCHAR(63) NOT NULL,
    to_position VARCHAR(63) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_position) REFERENCES nodes(position) ON DELETE CASCADE,
    FOREIGN KEY (to_position) REFERENCES nodes(position) ON DELETE CASCADE,
    UNIQUE(from_position, to_position)
);

-- Create game_plan_posts table (relating posts to game plans)
CREATE TABLE IF NOT EXISTS game_plan_posts (
    game_plan_id UUID NOT NULL,
    post_id UUID NOT NULL,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (game_plan_id, post_id),
    FOREIGN KEY (game_plan_id) REFERENCES game_plans(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- Add index for fast lookup by game plan
CREATE INDEX IF NOT EXISTS idx_game_plan_posts_game_plan_id ON game_plan_posts(game_plan_id);

-- Add index for fast lookup by post
CREATE INDEX IF NOT EXISTS idx_game_plan_posts_post_id ON game_plan_posts(post_id);

-- Create function for automatic node and edge creation when posts are added
CREATE OR REPLACE FUNCTION create_nodes_and_edges_for_post()
RETURNS TRIGGER AS $$
BEGIN
    -- Insert starting position node if it doesn't exist
    INSERT INTO nodes (position, top_bottom)
    VALUES (NEW.starting_position, NEW.starting_top_bottom::position_type)
    ON CONFLICT (position) DO NOTHING;
    
    -- Insert ending position node if it doesn't exist
    INSERT INTO nodes (position, top_bottom)
    VALUES (NEW.ending_position, NEW.ending_top_bottom::position_type)
    ON CONFLICT (position) DO NOTHING;
    
    -- If starting and ending positions are different, create an edge
    IF NEW.starting_position <> NEW.ending_position THEN
        INSERT INTO edges (from_position, to_position)
        VALUES (NEW.starting_position, NEW.ending_position)
        ON CONFLICT (from_position, to_position) DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create or replace the trigger
DROP TRIGGER IF EXISTS after_post_insert_update ON posts;
CREATE TRIGGER after_post_insert_update
AFTER INSERT OR UPDATE ON posts
FOR EACH ROW
EXECUTE FUNCTION create_nodes_and_edges_for_post();

-- Insert initial data for commonly used positions
INSERT INTO nodes (position, top_bottom)
VALUES 
    ('Closed Guard', 'BOTTOM'),
    ('Half Guard', 'BOTTOM'),
    ('Open Guard', 'BOTTOM'),
    ('Side Control', 'TOP'),
    ('Mount', 'TOP'),
    ('Back Control', 'TOP'),
    ('Standing', 'NEUTRAL'),
    ('Turtle', 'BOTTOM')
ON CONFLICT (position) DO NOTHING;