FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 g++ \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY runner.py /opt/runner.py
USER 65534:65534
WORKDIR /work
ENTRYPOINT ["/usr/bin/python3", "-I", "/opt/runner.py"]
