# Allowlist egress proxy. Only domains listed in /etc/tinyproxy/filter (generated from
# swarm.yaml network.allowlist into docker/proxy/filter) are reachable; everything else is denied.
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
