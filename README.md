NEAR Kurtosis Lambda
=====================
This repository contains a [Kurtosis Lambda](https://docs.kurtosistech.com/advanced-usage.html#kurtosis-lambdas) for setting up a NEAR network inside of Kurtosis.

Janky Things
------------
* There's no working contract-helper Docker image
    * The Dockerfile needed to be set to:
        ```
        # TODO pin the Node version
        FROM node:12
        WORKDIR /usr/app
        COPY ./package.json .
        COPY ./yarn.lock .
        RUN yarn
        COPY . .
        CMD ["sh", "-c",  "yarn start-no-env"]
        ```
      and the `package.json` needed this added: `    "start-no-env": "supervisor app",`
* We create databases for the contract-helper and the indexer from the result of:
    1. Starting a Postgres locally
    1. Cloning the contract-helper Git repo
    1. Running the contract helper migration locally
    1. Cloning the indexer-for-explorer Git repo
    1. Running the indexer-for-explorer migration locally (which requires installing `diesel`)
* There was no indexer-for-explorer image, so I had to make one:
    ```
    # syntax=docker/dockerfile-upstream:experimental

    FROM ubuntu:18.04 as build

    RUN apt-get update -qq && apt-get install -y \
        git \
        cmake \
        g++ \
        pkg-config \
        libssl-dev \
        curl \
        llvm \
        clang \
        && rm -rf /var/lib/apt/lists/*

    COPY ./rust-toolchain /tmp/rust-toolchain

    ENV RUSTUP_HOME=/usr/local/rustup \
        CARGO_HOME=/usr/local/cargo \
        PATH=/usr/local/cargo/bin:$PATH

    RUN curl https://sh.rustup.rs -sSf | \
        sh -s -- -y --no-modify-path --default-toolchain "$(cat /tmp/rust-toolchain)"

    VOLUME [ /near ]
    WORKDIR /near
    COPY . .

    ENV CARGO_TARGET_DIR=/tmp/target
    ENV RUSTC_FLAGS='-C target-cpu=x86-64'
    ENV PORTABLE=ON
    RUN cargo +"$(cat /tmp/rust-toolchain)" build --release && \
        mkdir /tmp/build && \
        cd /tmp/target/release && \
        mv ./indexer-explorer /tmp/build

    # COPY scripts/run_docker.sh /tmp/build/run.sh

    # Actual image
    FROM ubuntu:18.04

    WORKDIR /run

    EXPOSE 3030 24567

    RUN apt-get update -qq && apt-get install -y \
        libssl-dev ca-certificates \
        && rm -rf /var/lib/apt/lists/*

    COPY --from=build /tmp/build/indexer-explorer /usr/local/bin

    CMD /usr/local/bin/indexer-explorer --home-dir /root/.near/localnet init --fast --chain-id localnet
    ```
* The NEAR wallet is out-of-date, so I used the `build_image.sh` in the `near-wallet` repo to build an updated one
