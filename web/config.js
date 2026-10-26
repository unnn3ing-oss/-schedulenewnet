// 由 docs/newsnet_config.json 內嵌（只含前端要用的設定常數，不含任何憑證）。改設定請先改 docs 再同步這裡。
(function (root, cfg) {
  if (typeof module === "object" && module.exports) module.exports = cfg; else root.NEWSNET_CONFIG = cfg;
})(typeof self !== "undefined" ? self : this, {
  "ip": {
    "name": "newsnet",
    "label": "網新",
    "canvas": [
      1080,
      1080
    ],
    "minLeadMinutes": 20,
    "defaultLeadMinutes": 30,
    "chunkBytes": 8388608,
    "maxVideoBytes": 4294967296,
    "wordmark": "wordmark_newsnet.png",
    "textCard": {
      "font": "hanwang",
      "shadow": true,
      "line_gap": 1.45,
      "center_on_canvas": true
    },
    "videoHashtag": "#焦點新聞影音都在TVBS"
  },
  "pages": [
    {
      "code": "news",
      "label": "新聞",
      "fb": "TVBS新聞",
      "utm": "utm_source=facebook&utm_medium=fbarticlepic",
      "rd": "主粉"
    },
    {
      "code": "ent",
      "label": "娛樂",
      "fb": "TVBS娛樂",
      "utm": "utm_source=facebook&utm_medium=tvbsteatimenewspic",
      "rd": "娛樂粉"
    },
    {
      "code": "shaokang",
      "label": "少康",
      "fb": "少康戰情室",
      "utm": "utm_source=facebook&utm_medium=2100roompic",
      "rd": "少康粉"
    },
    {
      "code": "jkk",
      "label": "擠看看",
      "fb": "擠看看",
      "utm": "utm_source=facebook&utm_medium=gkkcomments",
      "rd": ""
    },
    {
      "code": "intl",
      "label": "國際＋",
      "fb": "TVBS國際+",
      "utm": "utm_source=facebook&utm_medium=tvbspluspic",
      "rd": "國際＋粉"
    },
    {
      "code": "weather",
      "label": "氣象",
      "fb": "TVBS氣象",
      "utm": "utm_source=Facebook&utm_medium=18weather",
      "rd": ""
    }
  ],
  "layouts": {
    "newsnet_news": {
      "frame": "square",
      "limits": [
        15,
        15,
        15
      ],
      "canvas": [
        1080,
        1080
      ]
    },
    "newsnet_ent": {
      "frame": "square",
      "limits": [
        15,
        15,
        15
      ],
      "canvas": [
        1080,
        1080
      ]
    },
    "newsnet_shaokang": {
      "frame": "square",
      "limits": [
        15,
        15,
        15
      ],
      "canvas": [
        1080,
        1080
      ]
    },
    "newsnet_jkk": {
      "frame": "square",
      "limits": [
        15,
        15,
        15
      ],
      "canvas": [
        1080,
        1080
      ]
    },
    "newsnet_intl": {
      "frame": "wide",
      "limits": [
        10,
        16,
        16
      ],
      "canvas": [
        1200,
        675
      ]
    }
  },
  "frameDisplaySize": {
    "square": [
      300,
      300
    ],
    "wide": [
      400,
      225
    ]
  },
  "textCardStyles": [
    {
      "key": "flash",
      "label": "快訊紅",
      "bg": "#b00020",
      "fg": "#ffffff"
    },
    {
      "key": "intl",
      "label": "國際藍",
      "bg": "#0d2b6b",
      "fg": "#ffffff"
    },
    {
      "key": "wx",
      "label": "氣象青",
      "bg": "#0a6e7c",
      "fg": "#ffffff"
    },
    {
      "key": "life",
      "label": "生活橘",
      "bg": "#c46a1a",
      "fg": "#ffffff"
    },
    {
      "key": "night",
      "label": "深夜黑",
      "bg": "#111111",
      "fg": "#ffffff"
    },
    {
      "key": "money",
      "label": "財經綠",
      "bg": "#0f5132",
      "fg": "#ffffff"
    },
    {
      "key": "mocha",
      "label": "咖啡灰",
      "bg": "#5a5448",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-c80000",
      "label": "QPT #C80000",
      "bg": "#c80000",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-ff3916",
      "label": "QPT #FF3916",
      "bg": "#ff3916",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-5fa646",
      "label": "QPT #5FA646",
      "bg": "#5fa646",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-4c8b74",
      "label": "QPT #4C8B74",
      "bg": "#4c8b74",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-ff9900",
      "label": "QPT #FF9900",
      "bg": "#ff9900",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-1c6294",
      "label": "QPT #1C6294",
      "bg": "#1c6294",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-cb6ce6",
      "label": "QPT #CB6CE6",
      "bg": "#cb6ce6",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-d84040",
      "label": "QPT #D84040",
      "bg": "#d84040",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-ff7ead",
      "label": "QPT #FF7EAD",
      "bg": "#ff7ead",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-004aad",
      "label": "QPT #004AAD",
      "bg": "#004aad",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-000000",
      "label": "QPT #000000",
      "bg": "#000000",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-48413f",
      "label": "QPT #48413F",
      "bg": "#48413f",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-a6a6a6",
      "label": "QPT #A6A6A6",
      "bg": "#a6a6a6",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-5cafcc",
      "label": "QPT #5CAFCC",
      "bg": "#5cafcc",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-ffdd30",
      "label": "QPT #FFDD30",
      "bg": "#ffdd30",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-7261c9",
      "label": "QPT #7261C9",
      "bg": "#7261c9",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-d13885",
      "label": "QPT #D13885",
      "bg": "#d13885",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-3667a8",
      "label": "QPT #3667A8",
      "bg": "#3667a8",
      "fg": "#ffffff"
    },
    {
      "key": "qpt-3f8c59",
      "label": "QPT #3F8C59",
      "bg": "#3f8c59",
      "fg": "#ffffff"
    }
  ]
});
