-- A project claim survives Space detach and project deletion. Otherwise an
-- old standalone grant could revive when the current project binding vanishes.
CREATE TABLE IF NOT EXISTS project_space_claims (
  realm TEXT NOT NULL,
  space_id TEXT NOT NULL,
  PRIMARY KEY (realm, space_id)
);
DO $space_claims$
BEGIN
  EXECUTE $function$CREATE OR REPLACE FUNCTION record_project_space_claim() RETURNS trigger AS $body$
  BEGIN
    INSERT INTO project_space_claims(realm,space_id) VALUES(NEW.realm,NEW.space_id) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END;
  $body$ LANGUAGE plpgsql$function$;
  EXECUTE 'CREATE OR REPLACE TRIGGER project_space_claim AFTER INSERT OR UPDATE OF realm,space_id ON project_spaces FOR EACH ROW EXECUTE FUNCTION record_project_space_claim()';
END;
$space_claims$;
INSERT INTO project_space_claims(realm,space_id) SELECT realm,space_id FROM project_spaces ON CONFLICT DO NOTHING;
