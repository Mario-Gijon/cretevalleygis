FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb

WORKDIR /app

# QWC2's upstream lockfile is Yarn classic format.
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

COPY upstream/qwc2/package.json upstream/qwc2/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY upstream/qwc2/ ./

EXPOSE 5175
CMD ["yarn", "start", "--port", "5175"]
