import os

# Tests never talk to the real Supabase/RunPod/Anthropic.
for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RUNPOD_API_KEY", "RUNPOD_POD_ID"):
    os.environ.pop(k, None)
import os

os.environ.setdefault("TAPESTRY_HEADLINES", "0")
