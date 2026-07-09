-- Database schema for the 2-column context model
CREATE TABLE IF NOT EXISTS context_entries (
    title VARCHAR(255) PRIMARY KEY,
    content TEXT NOT NULL
);

-- Seed all context entries
INSERT INTO context_entries (title, content) VALUES
-- Profile entries: All facts about a person (basic info, preferences, interests, relationship, communication style)
('Profile of Yasmin', 'Yasmin is a half-German, half-Indian adolescent teenager born 10.10.2015 in Hamburg. She lives in Hambrug with her family. Yasmin is interested in arts and science.'),
('Profile of Anjali', 'Anjali is Yasmin''s mother. Her birthday was 25.01.1989. She lives with Yasmin in Hamburg. She is born Indian and speaks 4 languages fluently (Punjabi, Hindi, German, English).'),
('Profile of Christopher', 'Christopher is Yasmin''s father. His birthday was 03.12.1988. He lives with Yasmin in Hamburg. He likes "Dad-jokes".'),
('Profile of Zara', 'Zara is Yasmin''s older sister. Her birthday was 14.02.2012. She lives with Yasmin in Hamburg. Zara likes KPop (especially Enhypen). Zara uses youth language extensively.'),
('Profile of Samira', 'Samira is Yasmin''s younger sister. Her birthday was 07.04.2020. She lives with Yasmin in Hamburg. Samira likes playing video games on the Nintendo Switch.'),
('Profile of Ellena', 'Ellena is Yasmin''s youngest sister. Her birthday was 15.08.2022. She lives with Yasmin in Hamburg.'),
('Profile of Helge', 'Helge is Yasmin''s grandfather. He lives in Schleswig. Helge likes playing Age of Emmpires 4, but he is not good at it.'),
('Profile of Christine', 'Christine is Yasmin''s grandmother. She lives in Schleswig.'),
('Profile of Lennard', 'Lennard is Yasmin''s uncle. He lives in Flensburg.'),
('Profile of Jonas', 'Jonas is Yasmin''s uncle. He lives in Schleswig.'),
-- Family-level entry
('Family notes', '')
ON DUPLICATE KEY UPDATE content = VALUES(content);
