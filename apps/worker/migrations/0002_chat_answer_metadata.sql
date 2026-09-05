ALTER TABLE messages
ADD COLUMN confidence TEXT CHECK (confidence IN ('high', 'medium', 'low'));

ALTER TABLE messages
ADD COLUMN unanswered_questions_json TEXT NOT NULL DEFAULT '[]';
