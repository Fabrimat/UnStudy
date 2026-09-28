# Build context: repo root.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng tesseract-ocr-ita tesseract-ocr-nld tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-spa \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/worker apps/worker
RUN pip install --no-cache-dir ./apps/worker

ENV OCR_LANGS=eng+ita+nld+fra+deu+spa PYTHONUNBUFFERED=1
CMD ["python", "-m", "summarize_worker"]
