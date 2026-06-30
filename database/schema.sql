-- Database schema for dynamic context system

-- Table for context entries (simplified 2-column model)
CREATE TABLE context_entries (
    title VARCHAR(255) NOT NULL PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FULLTEXT INDEX idx_content_search (content)
);

-- Insert initial markdown context prose representing current user background
INSERT INTO context_entries (title, content) VALUES
('Background on anjali', 'Anjali is 36 years old and is Christopher''s daughter.'),
('Background on christopher', 'Christopher is 36 years old and is the user of the AI assistant.'),
('Background on zara', 'Zara is 13 years old and is Christopher''s younger sister.'),
('Background on samira', 'Samira is 5 years old and is Christopher''s older sister.'),
('Background on ellena', 'Ellena is 2 years old and is Christopher''s older sister.'),
('Background on helge', 'Helge is 57 years old and is Christopher''s granddaughter.'),
('Background on christine', 'Christine is 56 years old and is Christopher''s granddaughter.'),
('Background on lennard', 'Lennard is 34 years old and is Christopher''s niece.'),
('Background on jonas', 'Jonas is 29 years old and is Christopher''s niece.');
