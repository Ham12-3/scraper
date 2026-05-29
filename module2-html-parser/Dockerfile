FROM python:3.11-slim

WORKDIR /app

RUN pip install --upgrade pip --quiet && \
    pip install --no-cache-dir \
        "beautifulsoup4>=4.12" \
        "lxml>=5.2" \
        "pydantic>=2.7" \
        "anthropic>=0.28" \
        "python-dateutil>=2.9" \
        "flask>=3.0" \
        "gunicorn>=22.0"

COPY src/ ./src/

ENV PYTHONPATH=/app

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "60", "src.server:create_app()"]
