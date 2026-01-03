// 分页功能（AI 写的）
const pagination = {
    itemsPerPage: Math.floor(window.innerHeight / 30), // 根据屏幕高度动态计算每页显示数量
    currentPage: 1,
    totalPages: 1,
    
    init: function() {
        this.calculateItemsPerPage();
        this.createContent();
        this.setupPagination();
        
        // 窗口大小变化时重新计算
        window.addEventListener('resize', () => {
            this.calculateItemsPerPage();
            this.setupPagination();
        });
    },
    
    calculateItemsPerPage: function() {
        // 每页显示屏幕高度4倍的内容
        const screenHeight = window.innerHeight;
        const lineHeight = 20; // 估算每行高度
        this.itemsPerPage = Math.floor((screenHeight * 4) / lineHeight);
        
        // 设置最小和最大值
        this.itemsPerPage = Math.max(20, Math.min(this.itemsPerPage, 100));
    },
    
    createContent: function() {
        const contentList = document.getElementById('contentList');
        if (!contentList) return;
        
        // 生成示例内容（你可以替换为实际内容）
        for (let i = 1; i <= 200; i++) {
            const li = document.createElement('li');
            li.innerHTML = `
                <h3 style="margin: 20px 0 10px 0; color: #74c0fc;">项目 ${i}</h3>
                <p style="color: #adb5bd; margin-bottom: 20px;">
                    这是第 ${i} 个项目的描述内容。这是一个示例内容，用于展示分页功能的效果。
                    <a href="#" style="color: #4dabf7;">了解更多</a>
                </p>
                <div style="height: 1px; background: linear-gradient(90deg, transparent, rgba(77, 171, 247, 0.3), transparent); margin: 25px 0;"></div>
            `;
            li.dataset.page = Math.ceil(i / this.itemsPerPage);
            contentList.appendChild(li);
        }
    },
    
    setupPagination: function() {
        const contentItems = document.querySelectorAll('#contentList li');
        if (contentItems.length === 0) return;
        
        this.totalPages = Math.ceil(contentItems.length / this.itemsPerPage);
        
        // 显示或隐藏分页
        const paginationWrapper = document.getElementById('paginationWrapper');
        if (this.totalPages > 1) {
            paginationWrapper.style.display = 'block';
            this.renderPagination();
            this.showPage(1);
        } else {
            paginationWrapper.style.display = 'none';
        }
    },
    
    renderPagination: function() {
        const paginationElement = document.getElementById('pagination');
        if (!paginationElement) return;
        
        paginationElement.innerHTML = '';
        
        // 添加上一页按钮
        const prevLi = document.createElement('li');
        prevLi.className = this.currentPage === 1 ? 'disabled' : '';
        prevLi.innerHTML = `<a href="#" aria-label="Previous">&laquo;</a>`;
        prevLi.addEventListener('click', (e) => {
            e.preventDefault();
            if (this.currentPage > 1) {
                this.showPage(this.currentPage - 1);
            }
        });
        paginationElement.appendChild(prevLi);
        
        // 添加页码按钮
        const maxVisiblePages = 5;
        let startPage = Math.max(1, this.currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(this.totalPages, startPage + maxVisiblePages - 1);
        
        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }
        
        // 添加第一页和省略号
        if (startPage > 1) {
            const firstLi = document.createElement('li');
            firstLi.innerHTML = `<a href="#">1</a>`;
            firstLi.addEventListener('click', (e) => {
                e.preventDefault();
                this.showPage(1);
            });
            paginationElement.appendChild(firstLi);
            
            if (startPage > 2) {
                const ellipsisLi = document.createElement('li');
                ellipsisLi.className = 'disabled';
                ellipsisLi.innerHTML = `<a href="#">...</a>`;
                paginationElement.appendChild(ellipsisLi);
            }
        }
        
        // 添加页码
        for (let i = startPage; i <= endPage; i++) {
            const pageLi = document.createElement('li');
            pageLi.className = this.currentPage === i ? 'active' : '';
            pageLi.innerHTML = `<a href="#">${i}</a>`;
            pageLi.addEventListener('click', (e) => {
                e.preventDefault();
                this.showPage(i);
            });
            paginationElement.appendChild(pageLi);
        }
        
        // 添加最后页和省略号
        if (endPage < this.totalPages) {
            if (endPage < this.totalPages - 1) {
                const ellipsisLi = document.createElement('li');
                ellipsisLi.className = 'disabled';
                ellipsisLi.innerHTML = `<a href="#">...</a>`;
                paginationElement.appendChild(ellipsisLi);
            }
            
            const lastLi = document.createElement('li');
            lastLi.innerHTML = `<a href="#">${this.totalPages}</a>`;
            lastLi.addEventListener('click', (e) => {
                e.preventDefault();
                this.showPage(this.totalPages);
            });
            paginationElement.appendChild(lastLi);
        }
        
        // 添加下一页按钮
        const nextLi = document.createElement('li');
        nextLi.className = this.currentPage === this.totalPages ? 'disabled' : '';
        nextLi.innerHTML = `<a href="#" aria-label="Next">&raquo;</a>`;
        nextLi.addEventListener('click', (e) => {
            e.preventDefault();
            if (this.currentPage < this.totalPages) {
                this.showPage(this.currentPage + 1);
            }
        });
        paginationElement.appendChild(nextLi);
    },
    
    showPage: function(pageNumber) {
        this.currentPage = pageNumber;
        
        // 隐藏所有内容
        const contentItems = document.querySelectorAll('#contentList li');
        contentItems.forEach(item => {
            item.style.display = 'none';
        });
        
        // 显示当前页内容
        const startIndex = (pageNumber - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        
        contentItems.forEach((item, index) => {
            if (index >= startIndex && index < endIndex) {
                item.style.display = 'block';
            }
        });
        
        // 重新渲染分页
        this.renderPagination();
        
        // 滚动到顶部
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    }
};

// 页面加载完成后初始化分页
document.addEventListener('DOMContentLoaded', () => {
    pagination.init();
});