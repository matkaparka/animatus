import logging

# The service logs what it does; a test run should not print it.
logging.getLogger('singing').addHandler(logging.NullHandler())
