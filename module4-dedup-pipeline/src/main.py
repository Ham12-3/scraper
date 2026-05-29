"""Entry point for the Dedup Pipeline Kafka consumer."""
from .config_loader import load_config
from .kafka_consumer import run

if __name__ == "__main__":
    config = load_config()
    run(config)
