import copy
from defaults import DEFAULTS

def load_settings(user):
    merged = copy.deepcopy(DEFAULTS)
    merged.update(user)
    return merged
