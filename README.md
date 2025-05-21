Steps to make this work:

Get into the shell of the container:

```
docker exec -it -u rootn8n-enterprise-trial-container /bin/sh
```

The files are located in /usr/local/lib/node_modules/n8n/ and will need to be overwritten with the ones in this repo.
