FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY tickers.txt .
COPY templates/ templates/
COPY static/ static/

# Persistent data dir (mounted as a volume on Fly / Render).
RUN mkdir -p /data
ENV PORT=5000
ENV CHURNLENCE_DB=/data/portfolio.db
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:5000/api/portfolios || exit 1

CMD ["python", "app.py"]
