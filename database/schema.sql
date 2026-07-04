-- Database schema for the 2-column context model
CREATE TABLE IF NOT EXISTS context_entries (
    title VARCHAR(255) PRIMARY KEY,
    content TEXT NOT NULL
);

-- Seed initial proxy data
INSERT INTO context_entries (title, content) VALUES
('Background on Anjali', 'Anjali is Yasmin''s mother. Her birthday was 25.01.1989.'),
('Background on Christopher', 'Christopher is Yasmin''s father. His birthday was 03.12.1988.'),
('Background on Zara', 'Zara is Yasmin''s older sister. Her birthday was 14.02.2012.'),
('Background on Samira', 'Samira is Yasmin''s younger sister. Her birthday was 07.04.2020.'),
('Background on Ellena', 'Ellena is Yasmin''s youngest sister. Her birthday was 15.08.2022'),
('Background on Helge', 'Helge is Yasmin''s grandfather.'),
('Background on Christine', 'Christine is Yasmin''s grandmother.'),
('Background on Lennard', 'Lennard is Yasmin''s uncle.'),
('Background on Jonas', 'Jonas is Yasmin''s uncle.'),
('Background on Yasmin', 'Yasmin is interested in arts and science.')
ON DUPLICATE KEY UPDATE content = VALUES(content);
