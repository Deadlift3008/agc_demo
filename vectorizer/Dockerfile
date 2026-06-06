FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
# Сначала torch с CPU-индекса (без CUDA-колёс на гигабайты), потом остальное.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 9000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
