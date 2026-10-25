-- R02 (decision 54): a sell hold binds only the tokens the account's own buys minted (engine.holdOf(...).tokens), and a
-- transfer never moves a hold (held tokens cannot be transferred). The snapshot stores the count; NULL = a row from before
-- this migration (the API then treats every token sold as held, the worse case).
ALTER TABLE holds ADD COLUMN tokens numeric(78, 18);
