FROM postgres:16-alpine

COPY guardrails-shim.sh /usr/local/bin/guardrails-shim
RUN chmod +x /usr/local/bin/guardrails-shim

EXPOSE 8000
CMD ["guardrails-shim"]
