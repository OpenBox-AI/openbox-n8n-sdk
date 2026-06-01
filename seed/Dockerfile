FROM alpine:3.19
RUN apk add --no-cache curl jq postgresql-client
COPY seed.sh /usr/local/bin/seed.sh
RUN chmod +x /usr/local/bin/seed.sh
ENTRYPOINT ["/usr/local/bin/seed.sh"]
