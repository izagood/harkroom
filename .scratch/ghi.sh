#!/bin/sh
export GH_TOKEN=$(gh auth token --user izagood)
exec gh "$@"
