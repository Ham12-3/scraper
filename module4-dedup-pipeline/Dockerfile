FROM python:3.11-slim

WORKDIR /app

RUN pip install --upgrade pip --quiet && \
    pip install --no-cache-dir \
        "pandas>=2.2" \
        "numpy>=1.26" \
        "recordlinkage>=0.16" \
        "scikit-learn>=1.4" \
        "pydantic>=2.7" \
        "python-dateutil>=2.9" \
        "kafka-python>=2.0" \
        "psycopg2-binary>=2.9"

COPY src/ ./src/

ENV PYTHONPATH=/app

CMD ["python", "-m", "src.main"]
