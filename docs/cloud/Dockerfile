# Pin the reviewed Node 22 image digest with --build-arg NODE_IMAGE at release time.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /opt/qqmail
COPY --chown=0:0 --chmod=0444 dist/cloud-server.mjs dist/cloud-server.mjs.LEGAL.txt /opt/qqmail/dist/
USER 1000:1000
EXPOSE 8787
ENTRYPOINT ["node", "/opt/qqmail/dist/cloud-server.mjs", "--config=/run/secrets/qqmail.json"]
