# xmr-node-proxy

Supports all known cryptonight/heavy/light/pico coins:

* Monero (XMR), MoneroV (XMV), Monero Original (XMO), Monero Classic (XMC), ...
* Wownero (WOW), Masari (MSR), Electroneum (ETN), Graft (GRFT), Intense (ITNS)
* Stellite (XTL)
* Aeon (AEON), Turtlecoin (TRTL), IPBC/BitTube (TUBE)
* Sumokoin (SUMO), Haven (XHV), Loki (LOKI)
* ...

## Setup Instructions

Based on a clean Ubuntu 16.04 LTS minimal install

## Switching from other xmr-node-proxy repository

```bash
cd xmr-node-proxy
git remote set-url origin https://github.com/MoneroOcean/xmr-node-proxy.git && git pull -X theirs --no-edit && npm update
```

## Deployment via Installer on Linux

1. Create a user 'nodeproxy' and assign a password (or add an SSH key. If you prefer that, you should already know how to do it)

```bash
useradd -d /home/nodeproxy -m -s /bin/bash nodeproxy
passwd nodeproxy
```

2. Add your user to `/etc/sudoers`, this must be done so the script can sudo up and do it's job.  We suggest passwordless sudo.  Suggested line: `<USER> ALL=(ALL) NOPASSWD:ALL`.  Our sample builds use: `nodeproxy ALL=(ALL) NOPASSWD:ALL`

```bash
echo "nodeproxy ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
```

3. Log in as the **NON-ROOT USER** you just created and run the [deploy script](https://raw.githubusercontent.com/MoneroOcean/xmr-node-proxy/master/install.sh).  This is very important!  This script will install the proxy to whatever user it's running under!

```bash
curl -L https://raw.githubusercontent.com/MoneroOcean/xmr-node-proxy/master/install.sh | bash
```

3. Once it's complete, copy `config_example.json` to `config.json` and edit as desired.
4. Run: `source ~/.bashrc`  This will activate NVM and get things working for the following pm2 steps.
8. Once you're happy with the settings, go ahead and start all the proxy daemon, commands follow.

```shell
cd ~/xmr-node-proxy/
pm2 start proxy.js --name=proxy --log-date-format="YYYY-MM-DD HH:mm:ss:SSS Z"
pm2 save
```
You can check the status of your proxy by either issuing

```
pm2 logs proxy
```

or using the pm2 monitor

```
pm2 monit
```

## Updating xmr-node-proxy

```bash
cd xmr-node-proxy
./update.sh
```

## Deployment via Docker on Windows 10 with the Fall Creators Update (or newer)

1. Install and run [Docker for Windows](https://docs.docker.com/docker-for-windows/install/) with Linux containers mode.

2. Get xmr-node-proxy sources by downloading and unpacking the latest [xmr-node-proxy](https://github.com/MoneroOcean/xmr-node-proxy/archive/master.zip)
archive to xmr-node-proxy-master directory.

3. Got to xmr-node-proxy-master directory in Windows "Command Prompt" and build xmr-node-proxy Docker image:

```
docker build . -t xmr-node-proxy
```

4. Copy config_example.json to config.json and edit config.json file as desired (do not forget to update default XMR wallet).

5. Create xnp Docker contained based on xmr-node-proxy image (make sure to update port numbers if you changed them in config.json):

```
docker create -p 3333:3333 -p 8080:8080 -p 8443:8443 --name xnp xmr-node-proxy
```

6. Copy your modified config.json to xnp Docker container:

```
docker cp config.json xnp:/xmr-node-proxy
```

7. Run xnp Docker container (or attach to already running one):

```
docker start --attach xnp
```

8. Stop xnp Docker container (to start it again with update):

```
docker stop xnp
```

9. Delete xnp Docker container (if you want to create it again with different ports):

```
docker rm xnp
```

10. Delete xmr-node-proxy Docker image (if you no longer need proxy):

```
docker rmi xmr-node-proxy
```


## Configuration BKMs

1. Specify at least one main pool with non zero share and "default: true". Sum of all non zero pool shares should be equal to 100 (percent).

2. There should be one pool with "default: true" (the last one will override previous ones with "default: true"). Default pool means pool that is used
for all initial miner connections via proxy.

3. You can use pools with zero share as backup pools. They will be only used if all non zero share pools became down.

4. You should select pool port with difficulty that is close to hashrate of all of your miners multiplied by 10.

5. Proxy ports should have difficulty close to your individual miner hashrate multiplied by 10.

6. Algorithm names ("algo" option in pool config section) can be taken from [Algorithm names and variants](https://github.com/xmrig/xmrig-proxy/blob/dev/doc/STRATUM_EXT.md#14-algorithm-names-and-variants) table

7. Blob type ("blob_type" option in pool config section) can be as follows

	* cryptonote  - Monero forks like Sumokoin, Electroneum, Graft, Aeon, Intense

	* cryptonote2 - Masari

	* forknote    - Some old Bytecoin forks (do not even know which one)

	* forknote2   - Bytecoin forks like Turtlecoin, IPBC

## Known Issues

VMs with 512Mb or less RAM will need some swap space in order to compile the C extensions for node.
Bignum and the CN libraries can chew through some serious memory during compile.
In regards to this here is guide for T2.Micro servers: [Setup of xmr-node-proxy on free tier AWS t2.micro instance](http://moneroocean.blogspot.com/2017/10/setup-of-xmr-node-proxy-on-free-tier.html).
There is also more generic proxy instalation guide: [Complete guide to install and configure xmr-node-proxy on a Ubuntu 16.04 VPS](https://tjosm.com/7689/install-xmr-node-proxy-vps/)

If not running on an Ubuntu 16.04 system, please make sure your kernel is at least 3.2 or higher, as older versions will not work for this.

Many smaller VMs come with ulimits set very low. We suggest looking into setting the ulimit higher. In particular, `nofile` (Number of files open) needs to be raised for high-usage instances.

In your `packages.json`, do a `npm install`, and it should pass.


## Performance

The proxy gains a massive boost over a basic pool by accepting that the majority of the hashes submitted _will_ not be valid (does not exceed the required difficulty of the pool).  Due to this, the proxy doesn't bother with attempting to validate the hash state nor value until the share difficulty exceeds the pool difficulty.

In testing, we've seen AWS t2.micro instances take upwards of 2k connections, while t2.small taking 6k.  The proxy is extremely light weight, and while there are more features on the way, it's our goal to keep the proxy as light weight as possible.

## Configuration Guidelines

Please check the [wiki](https://github.com/MoneroOcean/xmr-node-proxy/wiki/config_review) for information on configuration

Developer Donations
===================
If you'd like to make a one time donation, the addresses are as follows:
* XMR - ```89TxfrUmqJJcb1V124WsUzA78Xa3UYHt7Bg8RGMhXVeZYPN8cE5CZEk58Y1m23ZMLHN7wYeJ9da5n5MXharEjrm41hSnWHL```
* AEON - ```WmsEg3RuUKCcEvFBtXcqRnGYfiqGJLP1FGBYiNMgrcdUjZ8iMcUn2tdcz59T89inWr9Vae4APBNf7Bg2DReFP5jr23SQqaDMT```
* ETN - ```etnkQMp3Hmsay2p7uxokuHRKANrMDNASwQjDUgFb5L2sDM3jqUkYQPKBkooQFHVWBzEaZVzfzrXoETX6RbMEvg4R4csxfRHLo1```
* SUMO - ```Sumoo1DGS7c9LEKZNipsiDEqRzaUB3ws7YHfUiiZpx9SQDhdYGEEbZjRET26ewuYEWAZ8uKrz6vpUZkEVY7mDCZyGnQhkLpxKmy```
* GRFT - ```GACadqdXj5eNLnyNxvQ56wcmsmVCFLkHQKgtaQXNEE5zjMDJkWcMVju2aYtxbTnZgBboWYmHovuiH1Ahm4g2N5a7LuMQrpT```
* MSR - ```5hnMXUKArLDRue5tWsNpbmGLsLQibt23MEsV3VGwY6MGStYwfTqHkff4BgvziprTitbcDYYpFXw2rEgXeipsABTtEmcmnCK```
* ITNS - ```iz53aMEaKJ25zB8xku3FQK5VVvmu2v6DENnbGHRmn659jfrGWBH1beqAzEVYaKhTyMZcxLJAdaCW3Kof1DwTiTbp1DSqLae3e```
* WOW - ```Wo3yjV8UkwvbJDCB1Jy7vvXv3aaQu3K8YMG6tbY3Jo2KApfyf5RByZiBXy95bzmoR3AvPgNq6rHzm98LoHTkzjiA2dY7sqQMJ```
* XMV - ```XvyVfpAYp3zSuvdtoHgnDzMUf7GAeiumeUgVC7RTq6SfgtzGEzy4dUgfEEfD5adk1kN4dfVZdT3zZdgSD2xmVBs627Vwt2C3Ey```
* RYO - ```RYoLsi22qnoKYhnv1DwHBXcGe9QK6P9zmekwQnHdUAak7adFBK4i32wFTszivQ9wEPeugbXr2UD7tMd6ogf1dbHh76G5UszE7k1```
* XLA - ```SvkpUizij25ZGRHGb1c8ZTAHp3VyNFU3NQuQR1PtMyCqdpoZpaYAGMfG99z5guuoktY13nrhEerqYNKXvoxD7cUM1xA6Z5rRY```
* XHV - ```hvxyEmtbqs5TEk9U2tCxyfGx2dyGD1g8EBspdr3GivhPchkvnMHtpCR2fGLc5oEY42UGHVBMBANPge5QJ7BDXSMu1Ga2KFspQR```
* TUBE - ```TubedBNkgkTbd2CBmLQSwW58baJNghD9xdmctiRXjrW3dE8xpUcoXimY4J5UMrnUBrUDmfQrbxRYRX9s5tQe7pWYNF2QiAdH1Fh```
* LOKI - ```L6XqN6JDedz5Ub8KxpMYRCUoQCuyEA8EegEmeQsdP5FCNuXJavcrxPvLhpqY6emphGTYVrmAUVECsE9drafvY2hXUTJz6rW```
* TRTL - ```TRTLv2x2bac17cngo1r2wt3CaxN8ckoWHe2TX7dc8zW8Fc9dpmxAvhVX4u4zPjpv9WeALm2koBLF36REVvsLmeufZZ1Yx6uWkYG```
* XTNC - ```XtazhSxz1bbJLpT2JuiD2UWFUJYSFty5SVWuF6sy2w9v8pn69smkUxkTVCQc8NKCd6CBMNDGzgdPRYBKaHdbgZ5SNptVH1yPCTQ```
* IRD - ```ir3DHyB8Ub1aAHEewMeUxQ7b7tQdWa7VL8M5oXDPohS3Me4nhwvALXM4mym2kWg9VsceT75dm6XWiWF1K4zu8RVQ1HJD8Z3R9```
* ARQ - ```ar4Ha6ZQCkKRhkKQLfexv7VZQM2MhUmMmU9hmzswCPK4T3o2rbPKZM1GxEoYg4AFQsh57PsEets7sbpU958FAvxo2RkkTQ1gE```
* XWP - ```fh4MCJrakhWGoS6Meqp6UxGE1GNfAjKaRdPjW36rTffDiqvEq2HWEKZhrbYRw7XJb3CXxkjL3tcYGTT39m5qgjvk1ap4bVu1R```
* XEQ - ```Tvzp9tTmdGP9X8hCEw1Qzn18divQajJYTjR5HuUzHPKyLK5fzRt2X73FKBDzcnHMDJKdgsPhUDVrKHVcDJQVmLBg33NbkdjQb```
* XTA - ```ipN5cNhm7RXAGACP4ZXki4afT3iJ1A6Ka5U4cswE6fBPDcv8JpivurBj3vu1bXwPyb8KZEGsFUYMmToFG4N9V9G72X4WpAQ8L```
* DERO - ```dero1qygrgnz9gea2rqgwhdtpfpa3mvagt5uyq0g92nurwrpk6wnn7hdnzqgudsv6t```
* CCX - ```ccx7dmnBBoRPuVcpKJSAVZKdSDo9rc7HVijFbhG34jsXL3qiqfRwu7A5ecem44s2rngDd8y8N4QnYK6WR3mXAcAZ5iXun9BQBx```
* BLOC - ```abLoc5iUG4a6oAb2dqygxkS5M2uHWx16zHb9fUWMzpSEDwm6T7PSq2MLdHonWZ16CGfnJKRomq75aZyviTo6ZjHeYQMzNAEkjMg```
* ZEPH - ```ZEPHYR2nic7ULkkmgZNX8a9i2tMbkxuCqjgWZYuee3awX7RhtmhoT98CwGEGrruWZVSKtA7Z7JC8m7oeYHtBD9cBEZzdEh9BSdq4q```
* SAL - ```SaLvdWKnkz6MvVgxXr2TWSDSvESz6EBcz3wmMFch2sQuMYz2sUQGVNDYhkYaSuvkDr9GSYp5h6BeQHnGK8HzKhqGeZCZzG3AHS3```
* XTM - ```12FrDe5cUauXdMeCiG1DU3XQZdShjFd9A4p9agxsddVyAwpmz73x4b2Qdy5cPYaGmKNZ6g1fbCASJpPxnjubqjvHDa5```
* RVN - ```RLVJv9rQNHzXS3Zn4JH8hfAHmm1LfECMxy```
* XNA - ```Nb931jkFtFN7QWpu4FqSThaoKajYjS5iFZ```
* CLORE - ```AdXPHtV8yb86a8QKsbs8gmUpRpcxufRn8n```
* RTM - ```RUCyaEZxQu3Eure73XPQ57si813RYAMQKC```
* KCN - ```kc1qchtxq2gw9dc4r58hcegd6n4jspew6j9mu3yz8q```
* BTRM - ```Bfhtr2g56tg73TNZBRCu6fJUD39Kur6SGG```
* ERG - ```9fe533kUzAE57YfPP6o3nzsYMKN2W2uCxvg8KG8Vn5DDeJGetRw```
* BTC - ```3HRbMgcvbqHVW7P34MNGvF2Gh3DE26iHdw```
* BCH - ```18sKoDSjLCFW9kZrXuza1qzEERnKi7bx8S```
* ETH - ```0xfE23a61548FCCE159a541FAe9e16cEB92Da650ed```
* ETC - ```0x4480Ad73a113BEFf05B2079E38D90c9757Ecb063```
* LTC - ```MGj8PU1PpTNDDqRHmuEqfDpH3gxp6cJrUU```

## Known Working Pools

* [XMRPool.net](https://xmrpool.net)
* [supportXMR.com](https://supportxmr.com)
* [pool.xmr.pt](https://pool.xmr.pt)
* [minemonero.pro](https://minemonero.pro)
* [XMRPool.xyz](https://xmrpool.xyz)
* [ViaXMR.com](https://viaxmr.com)
* [mine.MoneroPRO.com](https://mine.moneropro.com)
* [MinerCircle.com](https://www.minercircle.com)
* [xmr.p00ls.net](https://www.p00ls.net)
* [MoriaXMR.com](https://moriaxmr.com)
* [MoneroOcean.stream](https://moneroocean.stream)
* [SECUmine.net](https://secumine.net)
* [Chinaenter.cn](http://xmr.chinaenter.cn)
* [XMRPool.eu](https://xmrpool.eu)

If you'd like to have your pool added, please make a pull request here, or contact MoneroOcean at support@moneroocean.stream!
