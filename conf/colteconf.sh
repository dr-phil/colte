#!/bin/bash
cd /etc/colte/colteconf
sudo virtualenv env
sudo source env/bin/activate
sudo pip install ruamel.yaml
sudo python colteconf.py
exit