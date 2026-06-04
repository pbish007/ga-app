# lakeFS OSS for the FAA registry R2 bucket.
# Pinned tag chosen here on each Fly deploy. Override at build time with --build-arg if needed.
ARG LAKEFS_VERSION=1.69.0
FROM treeverse/lakefs:${LAKEFS_VERSION}

# lakeFS listens on 8000 by default; Fly's http_service maps to this.
EXPOSE 8000
