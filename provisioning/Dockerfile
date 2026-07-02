# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# One-shot provisioner: logs in over gRPC, creates the tenant + API key, writes
# the connection artifacts to the shared volume, then exits.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
# chirpstack-api ships the gRPC stubs; grpcio/protobuf come along as deps.
RUN pip install --no-cache-dir chirpstack-api
COPY provision.py ./
CMD ["python", "provision.py"]
